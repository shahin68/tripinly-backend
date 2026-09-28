import { ValidationError, ValidationPipe } from '@nestjs/common';
import { AppException } from './app.exception';

/**
 * Flattens class-validator errors into `{ "path.to.field": ["isString", ...] }`.
 * Constraint names are stable identifiers the client can map to its own text.
 */
export function flattenValidationErrors(
  errors: ValidationError[],
  parentPath = '',
): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const error of errors) {
    const path = parentPath
      ? `${parentPath}.${error.property}`
      : error.property;
    if (error.constraints) {
      fields[path] = Object.keys(error.constraints);
    }
    if (error.children?.length) {
      Object.assign(fields, flattenValidationErrors(error.children, path));
    }
  }
  return fields;
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    stopAtFirstError: false,
    exceptionFactory: (errors) =>
      AppException.validation(flattenValidationErrors(errors)),
  });
}
