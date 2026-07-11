// server/defaultCalendar.js
// This is the placeholder DEMO calendar. Replace it any time -- either by
// editing this file directly, or (recommended) through the Admin dashboard's
// "Edit Calendar" screen once the real event calendar is finalized.
//
// Each block: { label, durationMinutes, moves: [{ companyId, pct }] }
// pct is the TOTAL drift over the whole block, applied gradually/linearly
// from the block's start price to (start price * (1 + pct/100)).
// Companies not listed in "moves" stay flat (0%) for that block.

module.exports = [
  {
    label: 'June-July: Admissions',
    durationMinutes: 12,
    moves: [
      { companyId: 'bus', pct: 15 },
      { companyId: 'xerox', pct: 10 },
      { companyId: 'library', pct: -10 }
    ]
  },
  {
    label: 'Aug-Sep: Regular Semester',
    durationMinutes: 12,
    moves: [
      { companyId: 'canteen', pct: 8 },
      { companyId: 'mess', pct: 8 }
    ]
  },
  {
    label: 'October: Fest Season',
    durationMinutes: 12,
    moves: [
      { companyId: 'fest', pct: 25 },
      { companyId: 'av', pct: 15 },
      { companyId: 'attendance', pct: -15 }
    ]
  },
  {
    label: 'Nov-Dec: Exam Season',
    durationMinutes: 12,
    moves: [
      { companyId: 'library', pct: 30 },
      { companyId: 'canteen', pct: 12 },
      { companyId: 'sports', pct: -15 },
      { companyId: 'bus', pct: -10 }
    ]
  },
  {
    label: 'Jan-Mar: Results, Placements & Sports',
    durationMinutes: 12,
    moves: [
      { companyId: 'placement', pct: 25 },
      { companyId: 'sports', pct: 20 },
      { companyId: 'library', pct: -15 }
    ]
  }
];
