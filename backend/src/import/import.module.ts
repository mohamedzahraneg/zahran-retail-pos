import { Module } from '@nestjs/common';
import { ImportService } from './import.service';
import { ImportController } from './import.controller';
import { CustomersImportService } from './customers-import.service';
import { SuppliersImportService } from './suppliers-import.service';
import { OpeningStockImportService } from './opening-stock-import.service';

@Module({
  providers: [
    ImportService,
    CustomersImportService,
    SuppliersImportService,
    OpeningStockImportService,
  ],
  controllers: [ImportController],
  exports: [
    ImportService,
    CustomersImportService,
    SuppliersImportService,
    OpeningStockImportService,
  ],
})
export class ImportModule {}
