import { useEffect, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Bold, Code2, Heading1, Heading2, Italic, Link2, List, ListChecks, ListOrdered, Quote, Redo2, Strikethrough, Undo2 } from 'lucide-react';
import { EMPTY_RICH_TEXT } from '../lib/rich-text';
import './rich-text-editor.css';

function parseDocument(value: string) {
  try {
    const doc: unknown = JSON.parse(value);
    if (doc && typeof doc === 'object' && 'type' in doc && doc.type === 'doc') return doc;
  } catch {
    // A malformed server response must never be interpreted as HTML.
  }
  return JSON.parse(EMPTY_RICH_TEXT);
}

export function RichTextEditor({ value, onChange, readOnly = false }: { value: string; onChange: (value: string) => void; readOnly?: boolean }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState('');
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false, autolink: false } }), TaskList, TaskItem.configure({ nested: true })],
    content: parseDocument(value),
    editable: !readOnly,
    editorProps: { attributes: { 'aria-label': '富文本正文', 'aria-multiline': 'true', role: 'textbox', class: 'rich-text-content', spellcheck: 'true' } },
    onUpdate: ({ editor: current }) => onChange(JSON.stringify(current.getJSON())),
  });

  useEffect(() => {
    if (!editor) return;
    const next = parseDocument(value);
    if (JSON.stringify(editor.getJSON()) !== JSON.stringify(next)) editor.commands.setContent(next, { emitUpdate: false });
  }, [editor, value]);

  useEffect(() => { editor?.setEditable(!readOnly); }, [editor, readOnly]);

  if (!editor) return null;
  const controls = [
    { label: '一级标题', icon: Heading1, active: editor.isActive('heading', { level: 1 }), run: () => editor.chain().focus().toggleHeading({ level: 1 }).run() },
    { label: '二级标题', icon: Heading2, active: editor.isActive('heading', { level: 2 }), run: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: '加粗', icon: Bold, active: editor.isActive('bold'), run: () => editor.chain().focus().toggleBold().run() },
    { label: '斜体', icon: Italic, active: editor.isActive('italic'), run: () => editor.chain().focus().toggleItalic().run() },
    { label: '删除线', icon: Strikethrough, active: editor.isActive('strike'), run: () => editor.chain().focus().toggleStrike().run() },
    { label: '无序列表', icon: List, active: editor.isActive('bulletList'), run: () => editor.chain().focus().toggleBulletList().run() },
    { label: '有序列表', icon: ListOrdered, active: editor.isActive('orderedList'), run: () => editor.chain().focus().toggleOrderedList().run() },
    { label: '任务列表', icon: ListChecks, active: editor.isActive('taskList'), run: () => editor.chain().focus().toggleTaskList().run() },
    { label: '引用', icon: Quote, active: editor.isActive('blockquote'), run: () => editor.chain().focus().toggleBlockquote().run() },
    { label: '代码块', icon: Code2, active: editor.isActive('codeBlock'), run: () => editor.chain().focus().toggleCodeBlock().run() },
  ];
  return <div className="rich-text-editor">
    {!readOnly && <div className="rich-text-toolbar" role="toolbar" aria-label="富文本格式">
      {controls.map(({ label, icon: Icon, active, run }) => <button key={label} type="button" aria-label={label} title={label} aria-pressed={active} onClick={run}><Icon size={16} /></button>)}
      <span className="rich-text-divider" />
      <button type="button" aria-label="插入链接" title="插入链接" aria-pressed={editor.isActive('link')} onClick={() => { setLink(editor.getAttributes('link').href ?? ''); setLinkOpen(open => !open); }}><Link2 size={16} /></button>
      <button type="button" aria-label="撤销" title="撤销" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}><Undo2 size={16} /></button>
      <button type="button" aria-label="重做" title="重做" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}><Redo2 size={16} /></button>
    </div>}
    {linkOpen && !readOnly && <form className="rich-text-link" onSubmit={event => {
      event.preventDefault();
      const url = link.trim();
      if (url && !/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) return;
      if (url) editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
      else editor.chain().focus().extendMarkRange('link').unsetLink().run();
      setLinkOpen(false);
    }}><input type="url" aria-label="链接地址" placeholder="https://…" value={link} onChange={event => setLink(event.target.value)} /><button type="submit">确定</button><button type="button" onClick={() => setLinkOpen(false)}>取消</button></form>}
    <EditorContent editor={editor} />
  </div>;
}

export default RichTextEditor;
