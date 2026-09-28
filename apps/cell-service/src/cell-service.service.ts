import { Injectable } from '@nestjs/common';

@Injectable()
export class CellServiceService {
  getHello(): string {
    return 'Hello World!';
  }
}
