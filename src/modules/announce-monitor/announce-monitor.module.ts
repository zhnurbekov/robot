import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '../http/http.module';
import { AuthModule } from '../auth/auth.module';
import { PortalModule } from '../portal/portal.module';
import { ApplicationModule } from '../application/application.module';
import { AnnounceMonitorService } from './announce-monitor.service';
import { AnnounceMonitorScheduler } from './announce-monitor.scheduler';

@Module({
  imports: [HttpModule, AuthModule, PortalModule, forwardRef(() => ApplicationModule)],
  providers: [AnnounceMonitorService, AnnounceMonitorScheduler],
  exports: [AnnounceMonitorService],
})
export class AnnounceMonitorModule {}

