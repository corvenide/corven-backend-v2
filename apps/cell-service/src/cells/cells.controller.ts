import {
    Controller,
    Get,
    Param,
} from '@nestjs/common';

import { CellsService } from './cells.service';

@Controller('cells')
export class CellsController {
    constructor(
        private readonly service: CellsService,
    ) { }

    @Get('live/:address')
    live(@Param('address') address: string) {
        return this.service.findLiveCells(address);
    }

    @Get(':outPoint')
    one(@Param('outPoint') outPoint: string) {
        return this.service.findOne(outPoint);
    }

    @Get(':outPoint/history')
    history(@Param('outPoint') outPoint: string) {
        return this.service.history(outPoint);
    }
}