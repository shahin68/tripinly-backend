import { Module } from '@nestjs/common';
import { ConsentsModule } from '../consents/consents.module';
import { UsersModule } from '../users/users.module';
import { AccessTokenService } from './access-token.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { AppleIdentityVerifier } from './identity/apple-identity.verifier';
import { GoogleIdentityVerifier } from './identity/google-identity.verifier';
import { RefreshTokenService } from './refresh-token.service';

@Module({
  imports: [ConsentsModule, UsersModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    AccessTokenService,
    RefreshTokenService,
    GoogleIdentityVerifier,
    AppleIdentityVerifier,
    AuthGuard,
  ],
  exports: [AccessTokenService, AuthGuard],
})
export class AuthModule {}
