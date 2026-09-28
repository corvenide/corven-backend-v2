// apps/auth-service/src/community/community.service.ts
//
// The community board: news (admins only), feedback and proposals (any
// signed-in user), comments and upvotes. Admins also set the status of
// feedback and proposals, pin posts, and can remove anything.

import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

import { PrismaService } from '@app/prisma';

import { CommunityAdmins } from './community-admins';

export const POST_KINDS = ['NEWS', 'FEEDBACK', 'PROPOSAL'] as const;
export const POST_STATUSES = ['OPEN', 'PLANNED', 'IN_PROGRESS', 'DONE', 'DECLINED'] as const;

export type PostKind = (typeof POST_KINDS)[number];
export type PostStatus = (typeof POST_STATUSES)[number];

export const LIMITS = {
    titleMin: 3,
    titleMax: 140,
    bodyMax: 10_000,
    commentMax: 3_000,
    pageSize: 20,
};

function fail(statusCode: number, message: string): RpcException {
    return new RpcException({ statusCode, message });
}

interface AuthorRecord {
    id: string;
    name: string;
    walletAddress: string | null;
}

const AUTHOR_SELECT = { select: { id: true, name: true, walletAddress: true } } as const;

@Injectable()
export class CommunityService {
    private readonly adminCache = new Map<string, Promise<boolean>>();

    constructor(
        private readonly prisma: PrismaService,
        private readonly admins: CommunityAdmins,
    ) { }

    // ------------------------------------------------------------------
    // Permissions
    // ------------------------------------------------------------------

    private isAdminAddress(walletAddress: string | null): Promise<boolean> {
        if (!walletAddress) return Promise.resolve(false);

        let cached = this.adminCache.get(walletAddress);
        if (!cached) {
            cached = this.admins.isAdmin(walletAddress);
            this.adminCache.set(walletAddress, cached);
        }
        return cached;
    }

    private async userIsAdmin(userId: string | undefined): Promise<boolean> {
        if (!userId) return false;
        const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { walletAddress: true } });
        return this.isAdminAddress(user?.walletAddress ?? null);
    }

    async permissions(data: { userId?: string }) {
        return { isAdmin: await this.userIsAdmin(data.userId) };
    }

    // ------------------------------------------------------------------
    // Reading
    // ------------------------------------------------------------------

    async listPosts(data: {
        kind?: string;
        sort?: string;
        status?: string;
        offset?: number;
        viewerId?: string;
    }) {
        const kind = data.kind ? this.parseKind(data.kind) : undefined;
        const status = data.status ? this.parseStatus(data.status) : undefined;
        const offset = Math.max(0, Math.floor(Number(data.offset) || 0));
        const sortTop = data.sort === 'top';

        const where = {
            ...(kind ? { kind } : { kind: { in: ['FEEDBACK', 'PROPOSAL'] as PostKind[] } }),
            ...(status ? { status } : {}),
        };

        const [rows, total] = await Promise.all([
            this.prisma.communityPost.findMany({
                where,
                orderBy: [
                    { pinned: 'desc' },
                    ...(sortTop ? [{ voteCount: 'desc' as const }] : []),
                    { createdAt: 'desc' },
                ],
                skip: offset,
                take: LIMITS.pageSize,
                include: { author: AUTHOR_SELECT },
            }),
            this.prisma.communityPost.count({ where }),
        ]);

        const voted = await this.votedSet(data.viewerId, rows.map((row) => row.id));

        return {
            posts: await Promise.all(rows.map((row) => this.shapePost(row, voted.has(row.id)))),
            total,
            nextOffset: offset + rows.length < total ? offset + rows.length : null,
        };
    }

    async getPost(data: { postId: string; viewerId?: string }) {
        const post = await this.prisma.communityPost.findUnique({
            where: { id: data.postId },
            include: {
                author: AUTHOR_SELECT,
                comments: { orderBy: { createdAt: 'asc' }, include: { author: AUTHOR_SELECT } },
            },
        });

        if (!post) throw fail(404, 'Post not found');

        const voted = await this.votedSet(data.viewerId, [post.id]);

        return {
            ...(await this.shapePost(post, voted.has(post.id))),
            comments: await Promise.all(
                post.comments.map(async (comment) => ({
                    id: comment.id,
                    body: comment.body,
                    createdAt: comment.createdAt,
                    author: await this.shapeAuthor(comment.author),
                })),
            ),
        };
    }

    // ------------------------------------------------------------------
    // Writing
    // ------------------------------------------------------------------

    async createPost(data: { userId: string; kind: string; title: string; body: string }) {
        const kind = this.parseKind(data.kind);
        const { title, body } = this.validatePost(data.title, data.body);

        if (kind === 'NEWS' && !(await this.userIsAdmin(data.userId))) {
            throw fail(403, 'Only Corven maintainers can publish news');
        }

        const post = await this.prisma.communityPost.create({
            data: { kind, title, body, authorId: data.userId },
            include: { author: AUTHOR_SELECT },
        });

        return this.shapePost(post, false);
    }

    async updatePost(data: {
        userId: string;
        postId: string;
        title?: string;
        body?: string;
        status?: string;
        pinned?: boolean;
    }) {
        const post = await this.findPostOrFail(data.postId);
        const isAdmin = await this.userIsAdmin(data.userId);
        const isAuthor = post.authorId === data.userId;

        const changes: { title?: string; body?: string; status?: PostStatus; pinned?: boolean } = {};

        if (data.title !== undefined || data.body !== undefined) {
            if (!isAuthor && !isAdmin) throw fail(403, 'You can only edit your own posts');
            const { title, body } = this.validatePost(data.title ?? post.title, data.body ?? post.body);
            changes.title = title;
            changes.body = body;
        }

        if (data.status !== undefined || data.pinned !== undefined) {
            if (!isAdmin) throw fail(403, 'Only Corven maintainers can change status or pin posts');
            if (data.status !== undefined) changes.status = this.parseStatus(data.status);
            if (data.pinned !== undefined) changes.pinned = Boolean(data.pinned);
        }

        const updated = await this.prisma.communityPost.update({
            where: { id: post.id },
            data: changes,
            include: { author: AUTHOR_SELECT },
        });

        const voted = await this.votedSet(data.userId, [post.id]);
        return this.shapePost(updated, voted.has(post.id));
    }

    async deletePost(data: { userId: string; postId: string }) {
        const post = await this.findPostOrFail(data.postId);

        if (post.authorId !== data.userId && !(await this.userIsAdmin(data.userId))) {
            throw fail(403, 'You can only delete your own posts');
        }

        await this.prisma.communityPost.delete({ where: { id: post.id } });
        return { success: true };
    }

    async addComment(data: { userId: string; postId: string; body: string }) {
        const body = (data.body ?? '').trim();

        if (!body) throw fail(400, 'Write a comment first');
        if (body.length > LIMITS.commentMax) {
            throw fail(400, `Comments can be at most ${LIMITS.commentMax} characters`);
        }

        await this.findPostOrFail(data.postId);

        const comment = await this.prisma.$transaction(async (tx) => {
            const created = await tx.communityComment.create({
                data: { postId: data.postId, authorId: data.userId, body },
                include: { author: AUTHOR_SELECT },
            });
            await tx.communityPost.update({
                where: { id: data.postId },
                data: { commentCount: { increment: 1 } },
            });
            return created;
        });

        return {
            id: comment.id,
            body: comment.body,
            createdAt: comment.createdAt,
            author: await this.shapeAuthor(comment.author),
        };
    }

    async deleteComment(data: { userId: string; commentId: string }) {
        const comment = await this.prisma.communityComment.findUnique({ where: { id: data.commentId } });

        if (!comment) throw fail(404, 'Comment not found');

        if (comment.authorId !== data.userId && !(await this.userIsAdmin(data.userId))) {
            throw fail(403, 'You can only delete your own comments');
        }

        await this.prisma.$transaction([
            this.prisma.communityComment.delete({ where: { id: comment.id } }),
            this.prisma.communityPost.update({
                where: { id: comment.postId },
                data: { commentCount: { decrement: 1 } },
            }),
        ]);

        return { success: true };
    }

    /** Adds the user's upvote, or removes it if they already voted. */
    async toggleVote(data: { userId: string; postId: string }) {
        const post = await this.findPostOrFail(data.postId);

        if (post.kind === 'NEWS') throw fail(400, 'News posts can’t be upvoted');

        return this.prisma.$transaction(async (tx) => {
            const key = { postId_userId: { postId: post.id, userId: data.userId } };
            const existing = await tx.communityVote.findUnique({ where: key });

            if (existing) {
                await tx.communityVote.delete({ where: key });
                const updated = await tx.communityPost.update({
                    where: { id: post.id },
                    data: { voteCount: { decrement: 1 } },
                });
                return { voted: false, voteCount: updated.voteCount };
            }

            await tx.communityVote.create({ data: { postId: post.id, userId: data.userId } });
            const updated = await tx.communityPost.update({
                where: { id: post.id },
                data: { voteCount: { increment: 1 } },
            });
            return { voted: true, voteCount: updated.voteCount };
        });
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private parseKind(value: string): PostKind {
        const kind = String(value).toUpperCase();
        if (!(POST_KINDS as readonly string[]).includes(kind)) {
            throw fail(400, `Unknown post type: ${value}`);
        }
        return kind as PostKind;
    }

    private parseStatus(value: string): PostStatus {
        const status = String(value).toUpperCase();
        if (!(POST_STATUSES as readonly string[]).includes(status)) {
            throw fail(400, `Unknown status: ${value}`);
        }
        return status as PostStatus;
    }

    private validatePost(rawTitle: string, rawBody: string) {
        const title = (rawTitle ?? '').trim();
        const body = (rawBody ?? '').trim();

        if (title.length < LIMITS.titleMin || title.length > LIMITS.titleMax) {
            throw fail(400, `Titles need ${LIMITS.titleMin}–${LIMITS.titleMax} characters`);
        }
        if (!body) throw fail(400, 'Add some details');
        if (body.length > LIMITS.bodyMax) {
            throw fail(400, `Posts can be at most ${LIMITS.bodyMax.toLocaleString('en')} characters`);
        }

        return { title, body };
    }

    private async findPostOrFail(postId: string) {
        const post = await this.prisma.communityPost.findUnique({ where: { id: postId } });
        if (!post) throw fail(404, 'Post not found');
        return post;
    }

    private async votedSet(viewerId: string | undefined, postIds: string[]): Promise<Set<string>> {
        if (!viewerId || !postIds.length) return new Set();

        const votes = await this.prisma.communityVote.findMany({
            where: { userId: viewerId, postId: { in: postIds } },
            select: { postId: true },
        });

        return new Set(votes.map((vote) => vote.postId));
    }

    private async shapeAuthor(author: AuthorRecord) {
        return {
            id: author.id,
            name: author.name,
            walletAddress: author.walletAddress,
            isAdmin: await this.isAdminAddress(author.walletAddress),
        };
    }

    private async shapePost(
        post: {
            id: string;
            kind: string;
            title: string;
            body: string;
            status: string;
            pinned: boolean;
            voteCount: number;
            commentCount: number;
            createdAt: Date;
            updatedAt: Date;
            author: AuthorRecord;
        },
        hasVoted: boolean,
    ) {
        return {
            id: post.id,
            kind: post.kind,
            title: post.title,
            body: post.body,
            status: post.status,
            pinned: post.pinned,
            voteCount: post.voteCount,
            commentCount: post.commentCount,
            hasVoted,
            createdAt: post.createdAt,
            updatedAt: post.updatedAt,
            author: await this.shapeAuthor(post.author),
        };
    }
}

