import { Module } from '@nestjs/common';
import { NcanodeService } from './ncanode.service';
import { NcalayerSocketService } from './ncalayer-socket.service';
import { CryptoSocketService } from './crypto-socket.service';
import { NclayerService } from './nclayer.service';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [RedisModule],
  providers: [NcanodeService, NcalayerSocketService, CryptoSocketService, NclayerService],
  exports: [NcanodeService, CryptoSocketService, NclayerService],
})
export class NcanodeModule {}



