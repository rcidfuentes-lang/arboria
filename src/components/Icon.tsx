type IconName =
  | 'arrowLeft'
  | 'chevronDown'
  | 'chevronRight'
  | 'chevronUp'
  | 'check'
  | 'copy'
  | 'download'
  | 'fileBranch'
  | 'folderOpen'
  | 'gitMerge'
  | 'grip'
  | 'import'
  | 'logOut'
  | 'maximize'
  | 'minimize'
  | 'more'
  | 'plus'
  | 'printer'
  | 'trash'
  | 'upload'

type IconProps = {
  name: IconName
}

const paths: Record<IconName, string[]> = {
  arrowLeft: ['M19 12H5', 'm12 19-7-7 7-7'],
  chevronDown: ['m6 9 6 6 6-6'],
  chevronRight: ['m9 18 6-6-6-6'],
  chevronUp: ['m18 15-6-6-6 6'],
  check: ['M20 6 9 17l-5-5'],
  copy: [
    'M8 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z',
    'M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2',
  ],
  download: ['M12 3v12', 'm7-7-7 7-7-7', 'M5 21h14'],
  fileBranch: ['M6 3v12', 'M18 9a3 3 0 1 0-3-3', 'M6 15a3 3 0 1 0 3 3', 'M15 6a9 9 0 0 0-9 9'],
  folderOpen: ['M3 7h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z', 'M3 11h18'],
  gitMerge: ['M18 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M6 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M6 21V6', 'M15 15c-4.5 0-9-3.5-9-9'],
  grip: ['M9 5h.01', 'M15 5h.01', 'M9 12h.01', 'M15 12h.01', 'M9 19h.01', 'M15 19h.01'],
  import: ['M12 3v12', 'm7-7-7 7-7-7', 'M5 21h14'],
  logOut: ['M10 17l5-5-5-5', 'M15 12H3', 'M21 3v18'],
  maximize: ['M8 3H3v5', 'M16 3h5v5', 'M8 21H3v-5', 'M21 16v5h-5'],
  minimize: ['M8 3v5H3', 'M21 8h-5V3', 'M3 16h5v5', 'M16 21v-5h5'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  plus: ['M12 5v14', 'M5 12h14'],
  printer: [
    'M7 8V3h10v5',
    'M7 17H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2',
    'M7 14h10v7H7v-7Z',
  ],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 15H6L5 6', 'M10 11v6', 'M14 11v6'],
  upload: ['M12 21V9', 'm5 5-5-5-5 5', 'M5 3h14'],
}

export function Icon({ name }: IconProps) {
  return (
    <svg aria-hidden="true" className="icon" fill="none" viewBox="0 0 24 24">
      {paths[name].map((path) => (
        <path d={path} key={path} />
      ))}
    </svg>
  )
}
