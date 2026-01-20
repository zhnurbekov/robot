import { Module } from '@nestjs/common';
import { InputService } from './input.service';

@Module({
	providers: [InputService],
	exports: [InputService],
})
export class InputModule {}

