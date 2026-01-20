import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { HttpModule } from '../http/http.module';
import { PortalModule } from '../portal/portal.module';
import { SessionModule } from '../session/session.module';
import { NcanodeModule } from '../ncanode/ncanode.module';

@Module({
  imports: [HttpModule, PortalModule, SessionModule, NcanodeModule],
  providers: [AuthService],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}


