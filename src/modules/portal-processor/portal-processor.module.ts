import {Module, forwardRef} from '@nestjs/common';
import {ApplicationModule} from "../application/application.module";
import {PortalProcessorService} from './portal-processor.service';
import {HtmlParserService} from './html-parser.service';
import {AppendixService} from './appendix.service';
import {PortalModule} from '../portal/portal.module';
import {HttpModule} from '../http/http.module';
import {NcanodeModule} from '../ncanode/ncanode.module';
import {AuthModule} from '../auth/auth.module';
import {RedisModule} from '../redis/redis.module';
import {FileDownloaderCoreModule} from '../file-downloader/file-downloader-core.module';

@Module({
	imports: [PortalModule, HttpModule, NcanodeModule, AuthModule, RedisModule, FileDownloaderCoreModule, forwardRef(() => ApplicationModule)],
	providers: [PortalProcessorService, HtmlParserService, AppendixService],
	exports: [PortalProcessorService, HtmlParserService, AppendixService],
})
export class PortalProcessorModule {
}


