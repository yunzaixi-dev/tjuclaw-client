import { useState, type CSSProperties } from 'react';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { X } from 'lucide-react';

export type TimetableCourse = {
  id: string; name: string; place: string; teacher?: string;
  day: number; start: number; end: number; color: number;
};
const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const sections = [
  { start: 1, end: 4, label: '上午' },
  { start: 5, end: 8, label: '下午' },
  { start: 9, end: 12, label: '晚间' },
];

/** Seven days always fit the page. Full details are one tap away, not hidden in a tooltip. */
export function CampusTimetable({ courses, monday, todayIndex }: {
  courses: TimetableCourse[]; monday: Date; todayIndex: number;
}) {
  const [selected, setSelected] = useState<TimetableCourse | null>(null);
  return <>
    <div className="campus-schedule-scroll" aria-label="一周课程表">
      <div className="campus-week">
        <div className="campus-week-dates"><span className="campus-week-corner">节次</span>{days.map((day, index) => {
          const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index);
          return <div className={`campus-week-day${index === todayIndex ? ' is-today' : ''}`} key={day}>
            <span>{day}</span><small>{String(date.getMonth() + 1).padStart(2, '0')}/{String(date.getDate()).padStart(2, '0')}</small>
          </div>;
        })}</div>
        {sections.map(section => {
          const visible = courses.filter(course => course.start <= section.end && course.end >= section.start);
          // Stable interval lanes, rather than each course's independent overlap
          // index: partial overlaps otherwise get the same offset and hide a course.
          const lanes = new Map<string, number>();
          let laneCount = 1;
          for (let day = 0; day < 7; day++) {
            const ends: number[] = [];
            for (const course of visible.filter(item => item.day === day).sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id))) {
              let lane = ends.findIndex(end => end < course.start);
              if (lane < 0) lane = ends.length;
              ends[lane] = course.end;
              lanes.set(course.id, lane);
            }
            laneCount = Math.max(laneCount, ends.length);
          }
          return <div className="campus-day-section" key={section.start}>
          <h2 className="campus-day-break">{section.label}</h2>
          <div className="campus-period-grid" style={{ '--period-height': `${Math.max(64, laneCount * 48)}px` } as CSSProperties}>
            {Array.from({ length: 4 }, (_, index) => <span className="campus-period-label" style={{ gridRow: index + 1 }} key={index}>{section.start + index}</span>)}
            {days.map((day, index) => <div className={`campus-day-lane${index === todayIndex ? ' is-today' : ''}`} style={{ gridColumn: index + 2 }} key={day} />)}
            {visible.map(course => {
              const start = Math.max(course.start, section.start);
              const end = Math.min(course.end, section.end);
              // Colliding courses share a cell visibly; none is silently dropped by find().
              const overlaps = courses.filter(other => other.day === course.day && other.start <= end && other.end >= start &&
                other.start <= section.end && other.end >= section.start);
              const lane = lanes.get(course.id) ?? 0;
              return <button type="button" key={course.id}
                className={`campus-class color-${course.color}${overlaps.length > 1 ? ' is-conflicting' : ''}`}
                style={{ gridColumn: course.day + 2, gridRow: `${start - section.start + 1} / ${end - section.start + 2}`,
                  ...(overlaps.length > 1 ? { alignSelf: 'start', height: 44, marginTop: `${lane * 48}px` } : {}) }}
                aria-label={`${course.name}，${days[course.day]}第 ${course.start}–${course.end} 节，${course.place || '地点未提供'}，查看详情`}
                onClick={() => setSelected(course)}>
                <strong>{course.name}</strong><small>{course.place || '地点待定'}</small>
                {overlaps.length > 1 ? <span className="campus-course-conflict">重叠</span> : null}
              </button>;
            })}
          </div>
        </div>;
        })}
      </div>
    </div>
    {!courses.length ? <p className="campus-footnote" role="status">本周暂无课程，可以同步教务数据或手动添加。</p> : null}
    <Dialog open={Boolean(selected)} onOpenChange={open => { if (!open) setSelected(null); }}>
      <DialogContent className="campus-credential-dialog campus-course-dialog">
        <header className="campus-dialog-header"><div><DialogTitle>{selected?.name || '课程详情'}</DialogTitle>
          <DialogDescription>课程的完整安排与上课地点。</DialogDescription></div>
          <DialogClose asChild><button type="button" className="campus-dialog-close" aria-label="关闭课程详情"><X size={18} /></button></DialogClose>
        </header>
        {selected ? <dl className="campus-course-details">
          <div><dt>时间</dt><dd>{days[selected.day]} · 第 {selected.start}–{selected.end} 节</dd></div>
          <div><dt>地点</dt><dd>{selected.place || '未提供'}</dd></div>
          <div><dt>教师</dt><dd>{selected.teacher || '未提供'}</dd></div>
        </dl> : null}
      </DialogContent>
    </Dialog>
  </>;
}
