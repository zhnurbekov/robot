import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RedisModule } from '../redis/redis.module';
import { HttpRequestLog } from './entities/http-request-log.entity';
import { HttpLogCronService } from './http-log-cron.service';

@Module({
  imports: [
    RedisModule,
    TypeOrmModule.forFeature([HttpRequestLog]),
  ],
  providers: [HttpLogCronService],
  exports: [HttpLogCronService],
})
export class HttpLogCronModule {}
