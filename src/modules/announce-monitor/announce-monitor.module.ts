import { Module } from '@nestjs/common';
import { HttpModule } from '../http/http.module';
import { AuthModule } from '../auth/auth.module';
import { AnnounceMonitorService } from './announce-monitor.service';
import { AnnounceMonitorScheduler } from './announce-monitor.scheduler';

@Module({
  imports: [HttpModule, AuthModule],
  providers: [AnnounceMonitorService, AnnounceMonitorScheduler],
  exports: [AnnounceMonitorService],
})
export class AnnounceMonitorModule {}

