import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PortalModule } from '../portal/portal.module';
import { CabinetCronService } from './cabinet-cron.service';
import { CabinetCronScheduler } from './cabinet-cron.scheduler';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    PortalModule,
  ],
  providers: [CabinetCronService, CabinetCronScheduler],
  exports: [CabinetCronService],
})
export class CabinetCronModule {}
