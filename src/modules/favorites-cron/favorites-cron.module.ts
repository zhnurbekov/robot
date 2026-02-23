import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { PortalModule } from '../portal/portal.module';
import { HttpRequestLog } from '../http-log-cron/entities/http-request-log.entity';
import { FavoritesCronService } from './favorites-cron.service';

@Module({
  imports: [
    AuthModule,
    PortalModule,
    TypeOrmModule.forFeature([HttpRequestLog]),
  ],
  providers: [FavoritesCronService],
  exports: [FavoritesCronService],
})
export class FavoritesCronModule {}
