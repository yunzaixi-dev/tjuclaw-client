import { BookOpen, CalendarDays, GraduationCap, Map, MessageSquareText, QrCode, School, Timer } from 'lucide-react';

export const campusToolList = [
  { id: 'schedule', name: '课程表', Icon: CalendarDays },
  { id: 'entry', name: '入校码', Icon: QrCode },
  { id: 'map', name: '校园地图', Icon: Map },
  { id: 'calendar', name: '学校校历', Icon: BookOpen },
  { id: 'gpa', name: 'GPA', Icon: GraduationCap },
  { id: 'rooms', name: '空教室', Icon: School },
  { id: 'forum', name: '论坛', Icon: MessageSquareText },
  { id: 'focus', name: '番茄时钟', Icon: Timer },
] as const;
export type CampusToolId = typeof campusToolList[number]['id'];
