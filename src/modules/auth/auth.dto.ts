import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class GoogleSignInDto {
  @ApiProperty({
    description:
      'Google ID token from the Credential Manager / Google Sign-In SDK',
  })
  @IsString()
  @Length(1, 8192)
  idToken: string;
}

export class AppleSignInDto {
  @ApiProperty({ description: 'Identity token (JWT) from Sign in with Apple' })
  @IsString()
  @Length(1, 8192)
  identityToken: string;

  @ApiProperty({
    description:
      'Authorization code; exchanged for a token used to revoke the Apple session on account deletion',
  })
  @IsString()
  @Length(1, 2048)
  authorizationCode: string;

  @ApiPropertyOptional({
    description: 'Apple sends the name only on the first sign-in',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  givenName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  familyName?: string;
}

export class DevSignInDto {
  @ApiProperty({
    example: 'alice',
    description:
      'Any stable test identifier; the same subject signs in to the same account',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9._-]{1,64}$/)
  subject: string;

  @ApiPropertyOptional({ example: 'Alice' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  name?: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @Length(1, 512)
  refreshToken: string;
}

export class LogoutDto {
  @ApiProperty()
  @IsString()
  @Length(1, 512)
  refreshToken: string;

  @ApiPropertyOptional({
    description: "This device's FCM token, unregistered from push",
  })
  @IsOptional()
  @IsString()
  @Length(1, 4096)
  fcmToken?: string;
}

export class AuthTokensDto {
  @ApiProperty({ description: 'Bearer token for API calls' })
  accessToken: string;

  @ApiProperty({ example: '2026-09-28T12:15:00.000Z' })
  accessTokenExpiresAt: string;

  @ApiProperty({ description: 'Single use: each refresh returns a new one' })
  refreshToken: string;

  @ApiProperty({ example: '2026-11-27T12:00:00.000Z' })
  refreshTokenExpiresAt: string;

  @ApiProperty({
    description: 'Profile or consents still missing: show onboarding',
  })
  onboardingRequired: boolean;
}
