import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../common/errors/error-response.dto';

export const OPENAPI_JSON_PATH = 'v1/openapi.json';

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Tripinly API')
    .setDescription(
      'REST API for the Tripinly apps. Errors use `{ error: { code, message, details } }`; switch on `code`.',
    )
    .setVersion('1')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .build();
  return SwaggerModule.createDocument(app, config, {
    extraModels: [ErrorResponseDto],
    operationIdFactory: (controllerKey, methodKey) =>
      `${controllerKey.replace(/Controller$/, '')}_${methodKey}`,
  });
}

/** Serves the document at /v1/openapi.json, plus Swagger UI at /v1/docs outside production. */
export function setupOpenApi(app: INestApplication, withUi: boolean): void {
  const document = buildOpenApiDocument(app);
  SwaggerModule.setup('v1/docs', app, document, {
    jsonDocumentUrl: OPENAPI_JSON_PATH,
    swaggerUiEnabled: withUi,
    raw: ['json'],
  });
}
