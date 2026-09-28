import { Test, TestingModule } from '@nestjs/testing';
import { CellServiceController } from './cell-service.controller';
import { CellServiceService } from './cell-service.service';

describe('CellServiceController', () => {
  let cellServiceController: CellServiceController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [CellServiceController],
      providers: [CellServiceService],
    }).compile();

    cellServiceController = app.get<CellServiceController>(CellServiceController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(cellServiceController.getHello()).toBe('Hello World!');
    });
  });
});
