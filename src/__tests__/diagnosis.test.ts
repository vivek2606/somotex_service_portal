import { describe, expect, it } from 'vitest';
import { diagnose, questionnaire } from '../lib/diagnosis';
import { mapStockSheet, parseCsv } from '../lib/csv';

describe('diagnose', () => {
  it('has a questionnaire for each product family', () => {
    for (const cat of ['Residential AC', 'Refrigerator', 'Washing Machine', 'Television', 'Gas Cooker', 'Microwave'] as const) {
      expect(questionnaire(cat).length).toBeGreaterThan(3);
    }
  });

  it('ranks a gas leak first for a slightly-cool AC with a history of refills', () => {
    const d = diagnose(
      'Residential AC',
      { power: 'Yes', fan: 'Yes', air: 'Slightly cool', outdoor: 'Yes', regas: 'Yes' },
      'It is not cooling like before',
    );
    expect(d.suggestions[0].cause.id).toBe('ac-gas-leak');
    expect(d.suggestions.reduce((t, s) => t + s.likelihood, 0)).toBeGreaterThanOrEqual(98);
  });

  it('points to the outdoor unit when it does not run', () => {
    const d = diagnose('Residential AC', { power: 'Yes', fan: 'Yes', air: 'Room temperature', outdoor: 'No' }, '');
    expect(d.suggestions[0].cause.id).toBe('ac-capacitor');
  });

  it('uses the customer’s words', () => {
    const d = diagnose('Residential AC', {}, 'water is dripping on the wall from the indoor unit');
    expect(d.suggestions[0].cause.id).toBe('ac-drain');
  });

  it('escalates a gas smell on a cooker with safety advice', () => {
    const d = diagnose('Gas Cooker', { smell: 'Yes' }, '');
    expect(d.priority).toBe('Critical');
    expect(d.suggestions[0].cause.id).toBe('gc-leak');
    expect(d.advice[0]).toMatch(/close the cylinder valve/);
  });

  it('lets confirmed history break ties', () => {
    const answers = { power: 'Yes', comp: 'Yes', cool: 'Nothing cools', hot: 'Yes' };
    const without = diagnose('Refrigerator', answers, '');
    const withHistory = diagnose('Refrigerator', answers, '', { 'fr-choke': 20 });
    expect(withHistory.suggestions.findIndex((s) => s.cause.id === 'fr-choke')).toBeLessThan(
      without.suggestions.findIndex((s) => s.cause.id === 'fr-choke'),
    );
  });

  it('suggests nothing without evidence', () => {
    expect(diagnose('Television', {}, '').suggestions).toEqual([]);
  });
});

describe('refrigerant detection in stock sheets', () => {
  it('reads R-600 as R600a and recognises R-290', () => {
    const rows = mapStockSheet(parseCsv('Name,Qty\nR-600 gas,4\nR-600a,2\nR-290 cylinder,3\nR-22,5\n')).rows;
    expect(rows.map((r) => r.refrigerant)).toEqual(['R600a', 'R600a', 'R290', 'R22']);
  });
});

describe('Nigerian phrasing', () => {
  it('understands common Pidgin descriptions', () => {
    expect(diagnose('Residential AC', {}, 'The AC no dey cool again, e be like say gas don finish').suggestions[0].cause.id).toBe('ac-gas-leak');
    expect(diagnose('Chest Freezer', {}, 'My chest freezer no dey freeze again').suggestions[0].cause.id).toBe('fr-gas-leak');
    expect(diagnose('Gas Cooker', {}, 'I dey perceive gas for kitchen').suggestions[0].cause.id).toBe('gc-leak');
    expect(diagnose('Residential AC', {}, 'Since NEPA brought light the outside unit stopped').suggestions.some((s) => s.cause.id === 'ac-power')).toBe(true);
  });
});
