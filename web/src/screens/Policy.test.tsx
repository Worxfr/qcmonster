import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { POLICY_VERSION } from '../../../shared/policy';
import { Policy } from './Policy';

describe('page Politique de confidentialite', () => {
  it('affiche le texte de docs/legal (version, droits) sans etre connecte', () => {
    render(<Policy />);
    expect(screen.getByRole('heading', { name: 'Politique de confidentialité' })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`Version : ${POLICY_VERSION}`))).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tes droits' })).toBeInTheDocument();
  });
});
