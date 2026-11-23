import { EXPLORE_PERIODS } from '../discovery/explore.dto';
import { PLACE_CATEGORIES } from '../markers/markers.dto';
import { EXPLORE_PERIOD_ITEMS, PLACE_KINDS } from './app-lists';

describe('app lists', () => {
  it('lists every place kind once, each with its own icon', () => {
    expect(PLACE_KINDS.map((kind) => kind.key).sort()).toEqual(
      [...PLACE_CATEGORIES].sort(),
    );
    const icons = PLACE_KINDS.map((kind) => kind.icon);
    expect(new Set(icons).size).toBe(icons.length);
    expect(PLACE_KINDS[0]).toMatchObject({ key: 'other', icon: 1 });
  });

  it('offers every Explore period once, with one default', () => {
    expect(EXPLORE_PERIOD_ITEMS.map((period) => period.key)).toEqual([
      ...EXPLORE_PERIODS,
    ]);
    expect(
      EXPLORE_PERIOD_ITEMS.filter((period) => period.isDefault),
    ).toHaveLength(1);
  });
});
