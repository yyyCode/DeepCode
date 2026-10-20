import type { Character } from '../api';

type Props = {
  readonly characters: readonly Character[];
  readonly selectedId: string | null;
  readonly disabled: boolean;
  readonly onSelect: (character: Character) => void;
  readonly onCreate: () => void;
};

export function CharacterRail({ characters, selectedId, disabled, onSelect, onCreate }: Props) {
  return (
    <nav className="rail" aria-label="人物">
      {characters.map((character) => {
        const active = character.id === selectedId;
        return (
          <button
            key={character.id}
            type="button"
            className={`rail__item${active ? ' rail__item--active' : ''}`}
            onClick={() => onSelect(character)}
            disabled={disabled && !active}
            aria-current={active ? 'true' : undefined}
            title={character.name}
          >
            <span className={`rail__face avatar--${character.avatar}`} aria-hidden="true">
              {character.name.slice(0, 1)}
            </span>
            <span className="rail__name">{character.name}</span>
          </button>
        );
      })}
      <button
        type="button"
        className="rail__item rail__item--add"
        onClick={onCreate}
        disabled={disabled}
        title="新建人物"
        aria-label="新建人物"
      >
        <span className="rail__face rail__face--add" aria-hidden="true">
          ＋
        </span>
        <span className="rail__name">新建</span>
      </button>
    </nav>
  );
}
