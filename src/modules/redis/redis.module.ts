import { Module, Global } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * Глобальный модуль Redis для кэширования
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}

