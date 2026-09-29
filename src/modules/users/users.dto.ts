import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  DOCUMENT_TYPES,
  LOCALE_PATTERN,
  type DocumentTypeValue,
} from '../consents/consents.dto';

export const VISIBILITIES = ['public', 'private'] as const;
export type VisibilityValue = (typeof VISIBILITIES)[number];

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class OnboardingStateDto {
  @ApiProperty({
    description: 'Profile complete and all required consents given',
  })
  completed: boolean;

  @ApiProperty({
    enum: ['username', 'displayName', 'birthDate'],
    isArray: true,
  })
  missingProfileFields: ('username' | 'displayName' | 'birthDate')[];

  @ApiProperty({ enum: DOCUMENT_TYPES, isArray: true })
  missingConsents: DocumentTypeValue[];
}

export class MeDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: String, nullable: true, example: 'jonas.k' })
  username: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Jonas' })
  displayName: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '1995-04-12',
    description: 'Only ever returned to its owner',
  })
  birthDate: string | null;

  @ApiProperty({ example: 'de-AT' })
  locale: string;

  @ApiProperty({ enum: VISIBILITIES })
  defaultTripVisibility: VisibilityValue;

  @ApiProperty({ enum: ['user', 'admin'] })
  role: 'user' | 'admin';

  @ApiProperty({ type: OnboardingStateDto })
  onboarding: OnboardingStateDto;

  @ApiProperty({
    type: [String],
    example: ['best_route_realtime'],
    description:
      'Active premium features. Show paid UI from this, never from a local flag.',
  })
  entitlements: string[];
}

export class UpdateMeDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 50 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 50)
  displayName?: string;

  @ApiPropertyOptional({
    example: 'jonas.k',
    description:
      'Set during onboarding; afterwards changeable once every 30 days',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  username?: string;

  @ApiPropertyOptional({
    example: '1995-04-12',
    description: 'Onboarding only. Users must be 16 or older.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  birthDate?: string;

  @ApiPropertyOptional({ example: 'de-AT' })
  @IsOptional()
  @IsString()
  @MaxLength(35)
  @Matches(LOCALE_PATTERN)
  locale?: string;

  @ApiPropertyOptional({ enum: VISIBILITIES })
  @IsOptional()
  @IsIn(VISIBILITIES)
  defaultTripVisibility?: VisibilityValue;
}

export class CheckUsernameQueryDto {
  @ApiProperty({ example: 'jonas.k' })
  @IsString()
  @MaxLength(60)
  username: string;
}

export class UsernameAvailabilityDto {
  @ApiProperty({ description: 'Normalized (trimmed, lowercase)' })
  username: string;

  @ApiProperty()
  available: boolean;

  @ApiPropertyOptional({ enum: ['invalid', 'taken'] })
  reason?: 'invalid' | 'taken';
}

export const PLATFORMS = ['ios', 'android'] as const;

export class FcmTokenParamDto {
  @ApiProperty()
  @IsString()
  @Length(20, 4096)
  @Matches(/^[A-Za-z0-9:_\-.]+$/)
  fcmToken: string;
}

export class RegisterDeviceDto {
  @ApiProperty({ enum: PLATFORMS })
  @IsIn(PLATFORMS)
  platform: (typeof PLATFORMS)[number];

  @ApiProperty({
    example: 'hu-HU',
    description: 'Device language, used to localize push',
  })
  @IsString()
  @MaxLength(35)
  @Matches(LOCALE_PATTERN)
  locale: string;
}
