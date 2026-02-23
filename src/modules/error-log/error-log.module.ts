import { Global, Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { ErrorLogService } from './error-log.service';

@Global()
@Module({
  imports: [RedisModule],
  providers: [ErrorLogService],
  exports: [ErrorLogService],
})
export class ErrorLogModule {}
