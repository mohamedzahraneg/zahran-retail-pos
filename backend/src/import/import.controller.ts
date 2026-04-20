import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { ImportService } from './import.service';
import { CustomersImportService } from './customers-import.service';
import { SuppliersImportService } from './suppliers-import.service';
import { OpeningStockImportService } from './opening-stock-import.service';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtUser,
} from '../common/decorators/current-user.decorator';

const FILE_BODY = {
  schema: {
    type: 'object',
    properties: { file: { type: 'string', format: 'binary' } },
  },
};

@ApiBearerAuth()
@ApiTags('import')
@Roles('admin', 'manager')
@Controller('import')
export class ImportController {
  constructor(
    private readonly svc: ImportService,
    private readonly customers: CustomersImportService,
    private readonly suppliers: SuppliersImportService,
    private readonly openingStock: OpeningStockImportService,
  ) {}

  // --------- Products ---------
  @Post('products/validate')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'التحقق من ملف منتجات (Dry-run)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody(FILE_BODY)
  async validateProducts(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { warehouse_code?: string },
  ) {
    if (!file?.buffer) throw new BadRequestException('ملف غير صحيح');
    return this.svc.parseAndValidate(file.buffer, {
      warehouseCode: body.warehouse_code,
    });
  }

  @Post('products')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'تنفيذ استيراد المنتجات' })
  @ApiConsumes('multipart/form-data')
  async importProducts(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { warehouse_code?: string },
    @CurrentUser() user: JwtUser,
  ) {
    if (!file?.buffer) throw new BadRequestException('ملف غير صحيح');
    return this.svc.importRows(file.buffer, {
      warehouseCode: body.warehouse_code,
      userId: user.userId,
    });
  }

  // --------- Customers ---------
  @Post('customers/validate')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'التحقق من ملف العملاء (Dry-run)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody(FILE_BODY)
  async validateCustomers(@UploadedFile() file: Express.Multer.File) {
    if (!file?.buffer) throw new BadRequestException('ملف غير صحيح');
    return this.customers.parseAndValidate(file.buffer);
  }

  @Post('customers')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'تنفيذ استيراد العملاء' })
  @ApiConsumes('multipart/form-data')
  async importCustomers(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { upsert?: boolean | string },
    @CurrentUser() user: JwtUser,
  ) {
    if (!file?.buffer) throw new BadRequestException('ملف غير صحيح');
    const upsert = body.upsert == null
      ? true
      : !['false', 'no', '0'].includes(String(body.upsert).toLowerCase());
    return this.customers.importRows(file.buffer, {
      userId: user.userId,
      upsert,
    });
  }

  // --------- Suppliers ---------
  @Post('suppliers/validate')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'التحقق من ملف الموردين (Dry-run)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody(FILE_BODY)
  async validateSuppliers(@UploadedFile() file: Express.Multer.File) {
    if (!file?.buffer) throw new BadRequestException('ملف غير صحيح');
    return this.suppliers.parseAndValidate(file.buffer);
  }

  @Post('suppliers')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'تنفيذ استيراد الموردين' })
  @ApiConsumes('multipart/form-data')
  async importSuppliers(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { upsert?: boolean | string },
    @CurrentUser() user: JwtUser,
  ) {
    if (!file?.buffer) throw new BadRequestException('ملف غير صحيح');
    const upsert = body.upsert == null
      ? true
      : !['false', 'no', '0'].includes(String(body.upsert).toLowerCase());
    return this.suppliers.importRows(file.buffer, {
      userId: user.userId,
      upsert,
    });
  }

  // --------- Opening stock balances ---------
  @Post('opening-stock/validate')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'التحقق من ملف أرصدة المخزون الافتتاحية (Dry-run)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody(FILE_BODY)
  async validateOpeningStock(@UploadedFile() file: Express.Multer.File) {
    if (!file?.buffer) throw new BadRequestException('ملف غير صحيح');
    return this.openingStock.parseAndValidate(file.buffer);
  }

  @Post('opening-stock')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'تطبيق أرصدة المخزون الافتتاحية' })
  @ApiConsumes('multipart/form-data')
  async applyOpeningStock(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: JwtUser,
  ) {
    if (!file?.buffer) throw new BadRequestException('ملف غير صحيح');
    return this.openingStock.apply(file.buffer, { userId: user.userId });
  }
}
