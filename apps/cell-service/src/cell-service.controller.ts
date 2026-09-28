import { Controller, Get } from '@nestjs/common';
import { CellServiceService } from './cell-service.service';

@Controller()
export class CellServiceController {
  constructor(private readonly cellServiceService: CellServiceService) {}

  @Get()
  getHello(): string {
    return this.cellServiceService.getHello();
  }
}
