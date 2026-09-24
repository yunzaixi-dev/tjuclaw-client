import { authRequest } from './auth';

export type CampusCredentials = {
  wpyUsername: string;
  wpyPassword: string;
  officeUsername: string;
  officePassword: string;
};

export type CampusSession = {
  user_number: string;
  nickname: string;
  expires_at: string;
};

export type CampusClasses = {
  courses: unknown[];
  exams: unknown[];
  gpa: Record<string, unknown>;
};

export type OfficeCaptcha = {
  captcha_id: string;
  content_type: string;
  data: string;
  expires_at: string;
};

export type OfficeSession = {
  username: string;
  expires_at: string;
};

export type StudyroomItem = Record<string, unknown> & { id?: number; name?: string; free?: boolean };

export function connectCampus(credentials: CampusCredentials, signal?: AbortSignal) {
  return authRequest<CampusSession>('/api/campus/session', {
    method: 'POST',
    body: JSON.stringify({ account: credentials.wpyUsername, password: credentials.wpyPassword }),
    signal,
  });
}

export function readCampusSession(signal?: AbortSignal) {
  return authRequest<CampusSession>('/api/campus/session', { signal });
}

export function disconnectCampus() {
  return authRequest<Record<string, never>>('/api/campus/session', { method: 'DELETE' });
}

export function readSemester(signal?: AbortSignal) {
  return authRequest<{ semester: Record<string, unknown> }>('/api/campus/semester', { signal });
}

export function fetchOfficeCaptcha(signal?: AbortSignal) {
  return authRequest<OfficeCaptcha>('/api/campus/office/captcha', { signal });
}

export function connectOffice(credentials: Pick<CampusCredentials, 'officeUsername' | 'officePassword'>, captchaId: string, captcha: string, signal?: AbortSignal) {
  return authRequest<OfficeSession>('/api/campus/office/session', {
    method: 'POST',
    body: JSON.stringify({ username: credentials.officeUsername, password: credentials.officePassword, captcha_id: captchaId, captcha }),
    signal,
  });
}

export function readOfficeSession(signal?: AbortSignal) {
  return authRequest<OfficeSession>('/api/campus/office/session', { signal });
}

export function disconnectOffice() {
  return authRequest<Record<string, never>>('/api/campus/office/session', { method: 'DELETE' });
}

export function refreshOfficeSession(signal?: AbortSignal) {
  return authRequest<OfficeSession>('/api/campus/office/session/refresh', { method: 'POST', signal });
}

export function fetchAcademicClasses(signal?: AbortSignal) {
  return authRequest<CampusClasses>('/api/campus/academic/classes', { signal });
}

export function fetchAcademicExams(signal?: AbortSignal) {
  return authRequest<{ exams: unknown[] }>('/api/campus/academic/exams', { signal });
}

export function fetchAcademicGPA(signal?: AbortSignal) {
  return authRequest<{ gpa: Record<string, unknown> }>('/api/campus/academic/gpa', { signal });
}

export function fetchEntryCode(signal?: AbortSignal) {
  return authRequest<{ content: string; expires_at: string }>('/api/campus/entry-code', { signal });
}

export function fetchCampuses(signal?: AbortSignal) {
  return authRequest<{ data: StudyroomItem[] }>('/api/campus/studyroom/campuses', { signal });
}

export function fetchBuildings(campusId: number, signal?: AbortSignal) {
  return authRequest<{ data: StudyroomItem[] }>(`/api/campus/studyroom/campuses/${campusId}/buildings`, { signal });
}

export function fetchRooms(buildingId: number, session: number, date: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ session: String(session), date });
  return authRequest<{ data: StudyroomItem[] }>(`/api/campus/studyroom/buildings/${buildingId}/rooms?${query}`, { signal });
}

export function fetchRoomSchedule(roomId: number, signal?: AbortSignal) {
  return authRequest<{ data: StudyroomItem[] }>(`/api/campus/studyroom/rooms/${roomId}/schedule`, { signal });
}

export function fetchForumBanners(signal?: AbortSignal) {
  return authRequest<{ data: Record<string, unknown> }>('/api/campus/forum/banners', { signal });
}

export function fetchForumPosts(page = 1, signal?: AbortSignal) {
  return authRequest<{ data: Record<string, unknown> }>(`/api/campus/forum/posts?page=${page}`, { signal });
}
