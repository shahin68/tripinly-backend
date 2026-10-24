import { Module } from '@nestjs/common';
import { PlaceCoversService } from './place-covers.service';

@Module({
  providers: [PlaceCoversService],
  exports: [PlaceCoversService],
})
export class PlaceCoversModule {}
