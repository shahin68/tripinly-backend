import {
  Body,
  Controller,
  Get,
  HttpStatus,
  INestApplication,
  Module,
  Post,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import request from 'supertest';
import { Public } from '../../src/common/auth/auth.decorators';
import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { createTestApp } from '../utils/create-test-app';

class LocationDto {
  @IsNumber() @Min(-90) @Max(90) lat: number;
  @IsNumber() @Min(-180) @Max(180) lng: number;
}

class ProbeDto {
  @IsString() @IsNotEmpty() title: string;
  @ValidateNested() @Type(() => LocationDto) location: LocationDto;
}

@Public()
@Controller('test-probe')
class ProbeController {
  @Post()
  create(@Body() body: ProbeDto): ProbeDto {
    return body;
  }

  @Get('domain')
  domain(): never {
    throw new AppException(
      ErrorCode.TRIP_NOT_COPYABLE,
      HttpStatus.UNPROCESSABLE_ENTITY,
      {
        tripId: 't1',
      },
    );
  }

  @Get('crash')
  crash(): never {
    throw new Error('SELECT * FROM secrets -- internal detail');
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('Error format and i18n (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp({ imports: [ProbeModule] });
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  it('unknown routes return NOT_FOUND in the error shape', async () => {
    const response = await http().get('/v1/does-not-exist').expect(404);
    expect(response.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: "We couldn't find what you were looking for.",
        details: {},
      },
    });
  });

  it.each([
    ['de-AT,de;q=0.9', 'Wir konnten nicht finden, wonach du suchst.'],
    ['hu', 'Nem találtuk, amit keresel.'],
    ['fr-FR', "We couldn't find what you were looking for."],
  ])('localizes messages for Accept-Language %s', async (language, message) => {
    const response = await http()
      .get('/v1/does-not-exist')
      .set('Accept-Language', language)
      .expect(404);
    expect(response.body.error.message).toBe(message);
  });

  it('validation errors list failing fields with constraint names', async () => {
    const response = await http()
      .post('/v1/test-probe')
      .send({ title: '', location: { lat: 123, lng: 'east' }, extra: true })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.details.fields).toEqual({
      title: ['isNotEmpty'],
      'location.lat': ['max'],
      'location.lng': ['max', 'min', 'isNumber'],
      extra: ['whitelistValidation'],
    });
  });

  it('valid bodies pass through transformed', async () => {
    await http()
      .post('/v1/test-probe')
      .send({ title: 'Vienna', location: { lat: 48.2, lng: 16.37 } })
      .expect(201, { title: 'Vienna', location: { lat: 48.2, lng: 16.37 } });
  });

  it('malformed JSON is a VALIDATION_FAILED, not a crash', async () => {
    const response = await http()
      .post('/v1/test-probe')
      .set('Content-Type', 'application/json')
      .send('{"title":')
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('domain exceptions keep their status, code and details', async () => {
    const response = await http().get('/v1/test-probe/domain').expect(422);
    expect(response.body.error).toMatchObject({
      code: 'TRIP_NOT_COPYABLE',
      details: { tripId: 't1' },
    });
  });

  it('unexpected errors return INTERNAL_ERROR without leaking internals', async () => {
    const response = await http().get('/v1/test-probe/crash').expect(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(response.body)).not.toMatch(/SELECT|secrets|stack/);
  });

  it('echoes a well-formed X-Request-Id and generates one otherwise', async () => {
    const echoed = await http()
      .get('/v1/health')
      .set('X-Request-Id', 'client-req-12345');
    expect(echoed.headers['x-request-id']).toBe('client-req-12345');
    const generated = await http().get('/v1/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('serves the OpenAPI document at /v1/openapi.json', async () => {
    const response = await http().get('/v1/openapi.json').expect(200);
    expect(response.body.openapi).toMatch(/^3\./);
    expect(response.body.paths['/v1/health/ready']).toBeDefined();
  });
});
