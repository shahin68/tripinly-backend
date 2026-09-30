import { Module } from '@nestjs/common';
import { ExploreController } from './explore.controller';
import { ExploreService } from './explore.service';

/** Explore. Place discovery (in-view, nearby, popular) lives in the places module. */
@Module({
  controllers: [ExploreController],
  providers: [ExploreService],
})
export class DiscoveryModule {}
