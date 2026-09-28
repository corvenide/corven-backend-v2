import { Module } from '@nestjs/common';

import { PrismaModule } from '@app/prisma';

import { CellsController } from './cells.controller';
import { CellsService } from './cells.service';

@Module({
    imports: [PrismaModule],
    controllers: [CellsController],
    providers: [CellsService],
    exports: [CellsService],
})
export class CellsModule { }