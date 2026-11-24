import type { ReactNode } from 'react';
import { CLAIM_LABEL } from '../game';
import type { Claim } from '../types';

export function Pill({ status }: { status: Claim['status'] }) {
  const l = CLAIM_LABEL[status];
  if (!l) return null;
  return (
    <span className={`pill ${l.cls}`}>
      <span aria-hidden="true">{l.icon}</span> {l.text}
    </span>
  );
}

export function ErrorBox({ message }: { message: string | null }) {
  return message ? <p role="alert" className="error">{message}</p> : null;
}

export function Loading({ text = 'Chargement…' }: { text?: string }) {
  return <p role="status" className="muted">{text}</p>;
}

export function Bar({ pct, label }: { pct: number; label: string }) {
  return (
    <div className="bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <div className="bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="card">
      {title && <h2>{title}</h2>}
      {children}
    </section>
  );
}
