import type { ValidationError } from '@nestjs/common';
import { flattenValidationErrors } from './validation';

describe('flattenValidationErrors', () => {
  it('maps nested errors to dotted paths with constraint names', () => {
    const errors: ValidationError[] = [
      {
        property: 'title',
        constraints: { isString: 'x', isNotEmpty: 'y' },
        children: [],
      },
      {
        property: 'location',
        children: [
          { property: 'lat', constraints: { max: 'z' }, children: [] },
          { property: 'lng', constraints: { isNumber: 'w' }, children: [] },
        ],
      },
    ];
    expect(flattenValidationErrors(errors)).toEqual({
      title: ['isString', 'isNotEmpty'],
      'location.lat': ['max'],
      'location.lng': ['isNumber'],
    });
  });
});
