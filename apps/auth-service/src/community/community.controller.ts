// apps/auth-service/src/community/community.controller.ts

import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import { CommunityService } from './community.service';

@Controller()
export class CommunityController {
    constructor(private readonly community: CommunityService) { }

    @MessagePattern({ cmd: 'community.permissions' })
    permissions(@Payload() data: { userId?: string }) {
        return this.community.permissions(data);
    }

    @MessagePattern({ cmd: 'community.posts.list' })
    listPosts(@Payload() data: { kind?: string; sort?: string; status?: string; offset?: number; viewerId?: string }) {
        return this.community.listPosts(data);
    }

    @MessagePattern({ cmd: 'community.posts.get' })
    getPost(@Payload() data: { postId: string; viewerId?: string }) {
        return this.community.getPost(data);
    }

    @MessagePattern({ cmd: 'community.posts.create' })
    createPost(@Payload() data: { userId: string; kind: string; title: string; body: string }) {
        return this.community.createPost(data);
    }

    @MessagePattern({ cmd: 'community.posts.update' })
    updatePost(
        @Payload()
        data: { userId: string; postId: string; title?: string; body?: string; status?: string; pinned?: boolean },
    ) {
        return this.community.updatePost(data);
    }

    @MessagePattern({ cmd: 'community.posts.delete' })
    deletePost(@Payload() data: { userId: string; postId: string }) {
        return this.community.deletePost(data);
    }

    @MessagePattern({ cmd: 'community.comments.create' })
    addComment(@Payload() data: { userId: string; postId: string; body: string }) {
        return this.community.addComment(data);
    }

    @MessagePattern({ cmd: 'community.comments.delete' })
    deleteComment(@Payload() data: { userId: string; commentId: string }) {
        return this.community.deleteComment(data);
    }

    @MessagePattern({ cmd: 'community.posts.vote' })
    toggleVote(@Payload() data: { userId: string; postId: string }) {
        return this.community.toggleVote(data);
    }
}
