import { Injectable } from '@nestjs/common';
import { PrismaService } from 'libs/prisma/src/prisma.service';

@Injectable()
export class CellsService {
    constructor(
        private readonly prisma: PrismaService,
    ) { }

    async findLiveCells(address: string) {
        return this.prisma.cell.findMany({
            where: {
                status: 'LIVE',
                address: {
                    address,
                },
            },
            include: {
                lockScript: true,
                typeScript: true,
            },
        });
    }

    async findOne(outPoint: string) {
        return this.prisma.cell.findUnique({
            where: {
                outPoint,
            },
            include: {
                lockScript: true,
                typeScript: true,
                createdBy: true,
                consumedBy: true,
            },
        });
    }

    async history(outPoint: string) {
        const cell = await this.findOne(outPoint);

        return {
            created: cell?.createdBy,
            consumed: cell?.consumedBy,
        };
    }
}