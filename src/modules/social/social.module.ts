import { Module } from '@nestjs/common';
import { ModerationModule } from '../moderation/moderation.module';
import { PlacesModule } from '../places/places.module';
import { TripsModule } from '../trips/trips.module';
import { CommentsService } from './comments.service';
import { LikesService } from './likes.service';
import { SocialController } from './social.controller';

/** Comments and likes. */
@Module({
  imports: [TripsModule, PlacesModule, ModerationModule],
  controllers: [SocialController],
  providers: [CommentsService, LikesService],
})
export class SocialModule {}
