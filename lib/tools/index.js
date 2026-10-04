/** The seven dr_* / reading_chapter tools this plugin registers. */
import { drImportTool } from './import.js';
import { drReadTool } from './read.js';
import { drWriteTool } from './write.js';
import { drStatusTool } from './status.js';
import { drUsageTool } from './usage.js';
import { drExportEpubTool } from './export-epub.js';
import { readingChapterTool } from './chapter.js';

export function buildTools({ ctx, config, chapterSkill }) {
  return [
    drImportTool({ config }),
    drReadTool({ config }),
    drWriteTool({ config }),
    drStatusTool({ config }),
    drUsageTool({ ctx, config }),
    drExportEpubTool({ config }),
    readingChapterTool({ ctx, config, chapterSkill }),
  ];
}
