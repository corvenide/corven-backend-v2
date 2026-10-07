// apps/connect-service/src/dashboard/dashboard.controller.ts
//
// The Connect dashboard API, used by the "Connect" pages of Corven IDE:
//   https://<api domain>/connect/v1/dashboard/...
// Authenticated with the developer's Corven IDE access token.

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';

import { DashboardService } from './dashboard.service';
import { CurrentIdeUser, IdeUserGuard, type IdeUser } from './ide-user.guard';

@Controller('v1/dashboard')
@UseGuards(IdeUserGuard)
export class DashboardController {
    constructor(private readonly dashboard: DashboardService) { }

    @Get('apps')
    listApps(@CurrentIdeUser() user: IdeUser) {
        return this.dashboard.listApps(user);
    }

    @Post('apps')
    createApp(@CurrentIdeUser() user: IdeUser, @Body() body: any) {
        return this.dashboard.createApp(user, body ?? {});
    }

    @Get('apps/:appId')
    getApp(@CurrentIdeUser() user: IdeUser, @Param('appId') appId: string) {
        return this.dashboard.getApp(user, appId);
    }

    @Patch('apps/:appId')
    updateApp(@CurrentIdeUser() user: IdeUser, @Param('appId') appId: string, @Body() body: any) {
        return this.dashboard.updateApp(user, appId, body ?? {});
    }

    /** Body: { confirm: <app name> }. */
    @Post('apps/:appId/delete')
    @HttpCode(200)
    deleteApp(@CurrentIdeUser() user: IdeUser, @Param('appId') appId: string, @Body() body: any) {
        return this.dashboard.deleteApp(user, appId, body ?? {});
    }

    @Get('apps/:appId/stats')
    stats(@CurrentIdeUser() user: IdeUser, @Param('appId') appId: string, @Query('days') days?: string) {
        return this.dashboard.stats(user, appId, days);
    }

    @Get('apps/:appId/users')
    listUsers(@CurrentIdeUser() user: IdeUser, @Param('appId') appId: string, @Query() query: any) {
        return this.dashboard.listUsers(user, appId, query ?? {});
    }

    @Get('apps/:appId/users/:userId')
    getUser(@CurrentIdeUser() user: IdeUser, @Param('appId') appId: string, @Param('userId') userId: string) {
        return this.dashboard.getUser(user, appId, userId);
    }

    @Post('apps/:appId/users/:userId/sign-out')
    @HttpCode(200)
    signOutUser(@CurrentIdeUser() user: IdeUser, @Param('appId') appId: string, @Param('userId') userId: string) {
        return this.dashboard.signOutUser(user, appId, userId);
    }

    /** Body: { confirm: "DELETE" }. */
    @Post('apps/:appId/users/:userId/delete')
    @HttpCode(200)
    deleteUser(@CurrentIdeUser() user: IdeUser, @Param('appId') appId: string, @Param('userId') userId: string, @Body() body: any) {
        return this.dashboard.deleteUser(user, appId, userId, body ?? {});
    }

    @Get('apps/:appId/team')
    team(@CurrentIdeUser() user: IdeUser, @Param('appId') appId: string) {
        return this.dashboard.team(user, appId);
    }

    /** Body: { email?, role }. Returns the invite link (and emails it when SMTP is set up). */
    @Post('apps/:appId/invites')
    invite(@CurrentIdeUser() user: IdeUser, @Param('appId') appId: string, @Body() body: any) {
        return this.dashboard.invite(user, appId, body ?? {});
    }

    @Delete('apps/:appId/invites/:inviteId')
    revokeInvite(@CurrentIdeUser() user: IdeUser, @Param('appId') appId: string, @Param('inviteId') inviteId: string) {
        return this.dashboard.revokeInvite(user, appId, inviteId);
    }

    @Patch('apps/:appId/members/:memberId')
    changeRole(@CurrentIdeUser() user: IdeUser, @Param('appId') appId: string, @Param('memberId') memberId: string, @Body() body: any) {
        return this.dashboard.changeRole(user, appId, memberId, body ?? {});
    }

    @Delete('apps/:appId/members/:memberId')
    removeMember(@CurrentIdeUser() user: IdeUser, @Param('appId') appId: string, @Param('memberId') memberId: string) {
        return this.dashboard.removeMember(user, appId, memberId);
    }

    @Get('invites/:token')
    previewInvite(@CurrentIdeUser() user: IdeUser, @Param('token') token: string) {
        return this.dashboard.previewInvite(user, token);
    }

    @Post('invites/:token/accept')
    @HttpCode(200)
    acceptInvite(@CurrentIdeUser() user: IdeUser, @Param('token') token: string) {
        return this.dashboard.acceptInvite(user, token);
    }
}
