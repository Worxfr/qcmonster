import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/** Bouton d'une phrase de la relecture (nom: texte, puis « Phrase n »). */
export const sentenceBtn = (n: number) => screen.getByRole('button', { name: new RegExp(`\\. Phrase ${n}[,.]`) });
/** Bouton de la phrase n, une fois l'ecran charge. */
export const findSentence = (n: number) => screen.findByRole('button', { name: new RegExp(`\\. Phrase ${n}[,.]`) });
/** Ouvre la phrase n pour la corriger a sa place et renvoie son champ de texte. */
export async function openSentence(n: number): Promise<HTMLTextAreaElement> {
  await userEvent.click(await findSentence(n));
  return screen.getByLabelText(new RegExp(`^Phrase ${n}( |$)`)) as HTMLTextAreaElement;
}
/** Corrige la phrase n en ajoutant `extra` a la fin, puis valide avec Entree. */
export async function appendTo(n: number, extra: string) {
  const box = await openSentence(n);
  await userEvent.type(box, `${extra}{Enter}`);
}
