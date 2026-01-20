import { Module } from '@nestjs/common';
import { PortalService } from './portal.service';
import { HttpModule } from '../http/http.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [HttpModule, RedisModule],
  providers: [PortalService],
  exports: [PortalService],
})
export class PortalModule {}

