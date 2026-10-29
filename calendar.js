(function attachPortalCalendar(root, factory) {
  const calendar = factory();
  if (typeof module === 'object' && module.exports) module.exports = calendar;
  root.PortalCalendar = calendar;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createCalendarModule() {
  'use strict';

  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  const PERIODS = [
    { label: 'P1', start: '09:00', end: '09:57' },
    { label: 'P2', start: '09:58', end: '10:55' },
    { label: 'P3', start: '11:16', end: '12:13' },
    { label: 'P4', start: '13:04', end: '14:01' },
    { label: 'P5', start: '14:02', end: '15:00' }
  ];
  const BY_DAY = ['MO', 'TU', 'WE', 'TH', 'FR'];

  function escapeText(value) {
    return String(value ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/\r\n|\r|\n/g, '\\n')
      .replace(/,/g, '\\,')
      .replace(/;/g, '\\;');
  }

  function foldLine(line) {
    let output = '';
    let current = '';
    let byteLength = 0;
    for (const character of String(line)) {
      const size = new TextEncoder().encode(character).length;
      if (byteLength + size > 75) {
        output += `${current}\r\n `;
        current = character;
        byteLength = 1 + size;
      } else {
        current += character;
        byteLength += size;
      }
    }
    return output + current;
  }

  function parseTime(value) {
    const [hour, minute] = value.split(':').map(Number);
    return { hour, minute };
  }

  function localDateTime(date) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}00`;
  }

  function utcStamp(date) {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  }

  function nextStart(now, weekday, time) {
    const { hour, minute } = parseTime(time);
    const currentWeekday = now.getDay();
    const targetWeekday = weekday === 7 ? 0 : weekday;
    const daysUntil = (targetWeekday - currentWeekday + 7) % 7;
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntil, hour, minute, 0, 0);
    if (candidate <= now) candidate.setDate(candidate.getDate() + 7);
    return candidate;
  }

  function addMinutes(date, minutes) {
    const result = new Date(date);
    result.setMinutes(result.getMinutes() + minutes);
    return result;
  }

  function durationMinutes(start, end) {
    const startTime = parseTime(start);
    const endTime = parseTime(end);
    return (endTime.hour * 60 + endTime.minute) - (startTime.hour * 60 + startTime.minute);
  }

  function stableHash(value) {
    let hash = 2166136261;
    for (const character of String(value)) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function safeHomepage(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  }

  function createCalendar(state, options = {}) {
    const now = options.now instanceof Date ? options.now : new Date();
    const courses = state?.courses || {};
    const timetable = state?.timetable || {};
    const events = [];

    DAYS.forEach((day, dayIndex) => {
      const slots = Array.isArray(timetable[day]) ? timetable[day] : [];
      PERIODS.forEach((period, periodIndex) => {
        const course = courses[slots[periodIndex]];
        if (!course) return;
        const start = nextStart(now, dayIndex + 1, period.start);
        const end = addMinutes(start, durationMinutes(period.start, period.end));
        const homepage = safeHomepage(course.unitURL || course.homepageURL);
        const uid = `portal-${stableHash(`${day}|${periodIndex}|${course.id || course.displayName}`)}@portal-web`;
        const description = `${day} ${period.label} · ${period.start}–${period.end}. Repeats weekly; school holidays are not excluded.`;
        const lines = [
          'BEGIN:VEVENT',
          `UID:${uid}`,
          `DTSTAMP:${utcStamp(now)}`,
          `DTSTART:${localDateTime(start)}`,
          `DTEND:${localDateTime(end)}`,
          `RRULE:FREQ=WEEKLY;BYDAY=${BY_DAY[dayIndex]}`,
          `SUMMARY:${escapeText(`${course.displayName || 'Class'} · ${period.label}`)}`,
          `DESCRIPTION:${escapeText(description)}`,
          'CATEGORIES:School timetable',
          ...(homepage ? [`URL:${homepage}`] : []),
          'END:VEVENT'
        ];
        events.push(...lines);
      });
    });

    if (!events.length) return { content: '', eventCount: 0 };
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Portal Web//School Timetable//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Portal Timetable',
      ...events,
      'END:VCALENDAR'
    ];
    return { content: `${lines.map(foldLine).join('\r\n')}\r\n`, eventCount: events.filter(line => line === 'BEGIN:VEVENT').length };
  }

  return { DAYS, PERIODS, createCalendar };
});
