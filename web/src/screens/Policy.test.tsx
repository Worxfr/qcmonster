import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Policy } from './Policy';

describe('page Politique de confidentialite', () => {
  it('affiche le texte de docs/legal (version, droits) sans etre connecte', () => {
    render(<Policy />);
    expect(screen.getByRole('heading', { name: 'Politique de confidentialité' })).toBeInTheDocument();
    expect(screen.getByText(/Version : 2026-11-25/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tes droits' })).toBeInTheDocument();
  });
});
