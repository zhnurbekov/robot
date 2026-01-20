import { Module } from '@nestjs/common';
import { FileProcessorService } from './file-processor.service';
import { FileProcessorController } from './file-processor.controller';
import { HttpModule } from '../http/http.module';
import { NcanodeModule } from '../ncanode/ncanode.module';

@Module({
  imports: [HttpModule, NcanodeModule],
  controllers: [FileProcessorController],
  providers: [FileProcessorService],
  exports: [FileProcessorService],
})
export class FileProcessorModule {}

