import {Module, forwardRef} from '@nestjs/common';
import {PortalProcessorModule} from "../portal-processor/portal-processor.module";
import { ApplicationService } from './application.service';
import { ApplicationController } from './application.controller';
import { ApplicationScheduler } from './application.scheduler';
import { PortalModule } from '../portal/portal.module';
import { AuthModule } from '../auth/auth.module';
import { NcanodeModule } from '../ncanode/ncanode.module';
import { HttpModule } from '../http/http.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [PortalModule, AuthModule, NcanodeModule, forwardRef(() => PortalProcessorModule), HttpModule, RedisModule],
  providers: [ApplicationService, ApplicationScheduler],
  controllers: [ApplicationController],
  exports: [ApplicationService],
})
export class ApplicationModule {}

