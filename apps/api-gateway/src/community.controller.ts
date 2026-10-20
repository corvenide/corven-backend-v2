import {
    Body,
    Controller,
    Delete,
    Get,
    Headers,
    HttpCode,
    Param,
    Patch,
    Post,
    Query,
} from '@nestjs/common';

import { ApiGatewayService } from './api-gateway.service';
import { RateLimiter } from './auth-session';
import { getAccountUser, getUserFromAuthorizationHeader } from './auth-helpers';

@Controller('community')
export class CommunityController {
    constructor(private readonly gatewayService: ApiGatewayService) { }

    private readonly postLimiter = new RateLimiter(6, 10 * 60_000);
    private readonly commentLimiter = new RateLimiter(30, 10 * 60_000);
    private readonly voteLimiter = new RateLimiter(60, 60_000);

    // @Get('permissions')
    async getCommunityPermissions(@Headers('authorization') authorization?: string) {
        const user = await this.getOptionalUser(authorization);
        return this.gatewayService.communityPermissions(user?.id);
    }

    @Get('posts')
    listCommunityPosts(
        @Headers('authorization') authorization: string | undefined,
        @Query('kind') kind?: string,
        @Query('sort') sort?: string,
        @Query('status') status?: string,
        @Query('offset') offset?: string,
    ) {
        return this.gatewayService.listCommunityPosts({
            viewerId: (this.getOptionalUserSync(authorization))?.id,
            kind,
            sort,
            status,
            offset: offset ? Number(offset) : undefined,
        });
    }

    @Post('posts')
    async createCommunityPost(
        @Headers('authorization') authorization: string,
        @Body() body: { title: string; body: string; kind: string; linkUrl?: string; linkTitle?: string },
    ) {
        const user = await getAccountUser(this.gatewayService, authorization, 'post to the community');
        this.postLimiter.consume(`post:${user.id}`);

        return this.gatewayService.createCommunityPost({
            userId: user.id,
            title: body?.title,
            body: body?.body,
            kind: body?.kind,
        });
    }

    @Get('posts/:id')
    async getCommunityPost(
        @Headers('authorization') authorization: string | undefined,
        @Param('id') postId: string,
    ) {
        const user = await this.getOptionalUser(authorization);
        return this.gatewayService.getCommunityPost(postId, user?.id);
    }

    @Patch('posts/:id')
    async updateCommunityPost(
        @Headers('authorization') authorization: string,
        @Param('id') postId: string,
        @Body() body: { title?: string; body?: string; status?: string; pinned?: boolean },
    ) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);

        return this.gatewayService.updateCommunityPost({
            userId: user.id,
            postId,
            title: body?.title,
            body: body?.body,
            status: body?.status,
            pinned: body?.pinned,
        });
    }

    @Delete('posts/:id')
    async deleteCommunityPost(
        @Headers('authorization') authorization: string,
        @Param('id') postId: string,
    ) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);
        return this.gatewayService.deleteCommunityPost(user.id, postId);
    }

    @Post('posts/:id/comments')
    async addCommunityComment(
        @Headers('authorization') authorization: string,
        @Param('id') postId: string,
        @Body() body: { body: string },
    ) {
        const user = await getAccountUser(this.gatewayService, authorization, 'comment');
        this.commentLimiter.consume(`comment:${user.id}`);

        return this.gatewayService.addCommunityComment({ userId: user.id, postId, body: body?.body });
    }

    @Delete('comments/:id')
    async deleteCommunityComment(
        @Headers('authorization') authorization: string,
        @Param('id') commentId: string,
    ) {
        const user = await getUserFromAuthorizationHeader(this.gatewayService, authorization);
        return this.gatewayService.deleteCommunityComment(user.id, commentId);
    }

    @Post('posts/:id/vote')
    @HttpCode(200)
    async toggleCommunityVote(
        @Headers('authorization') authorization: string,
        @Param('id') postId: string,
    ) {
        const user = await getAccountUser(this.gatewayService, authorization, 'vote');
        this.voteLimiter.consume(`vote:${user.id}`);

        return this.gatewayService.toggleCommunityVote(user.id, postId);
    }

    private async getOptionalUser(authorization?: string): Promise<{ id: string } | undefined> {
        if (!authorization) return undefined;
        try {
            return await getUserFromAuthorizationHeader(this.gatewayService, authorization);
        } catch {
            return undefined;
        }
    }

    private getOptionalUserSync(authorization?: string): { id: string } | undefined {
        if (!authorization) return undefined;
        return undefined;
    }
}
