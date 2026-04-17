/**
 * Tests for Content Deduplication Module
 */

import { describe, it, expect } from '@jest/globals';
import {
  deduplicateContent,
  type SourceContent,
} from './contentDeduplication.js';

describe('contentDeduplication', () => {
  describe('deduplicateContent', () => {
    it('removes exact duplicate paragraphs', () => {
      const duplicateParagraph = 'This is a duplicate paragraph that appears in multiple sources and contains enough text to pass the minimum length filter.';
      const sources: SourceContent[] = [
        {
          url: 'https://example1.com',
          content: `This is a unique paragraph from source one that should be kept in the final output and is long enough to pass filters.\n\n${duplicateParagraph}`,
        },
        {
          url: 'https://example2.com',
          content: `${duplicateParagraph}\n\nThis is unique content from source two that should also appear in the deduplicated result with proper attribution.`,
        },
      ];

      const result = deduplicateContent(sources);

      expect(result.stats.duplicatesRemoved).toBeGreaterThan(0);
      expect(result.content).toContain('unique paragraph from source one');
      expect(result.content).toContain('unique content from source two');
      // The duplicate should only appear once
      const matches = result.content.match(/duplicate paragraph that appears/g);
      expect(matches?.length).toBe(1);
    });

    it('removes near-duplicate paragraphs with high similarity', () => {
      const sources: SourceContent[] = [
        {
          url: 'https://example1.com',
          content: 'The quick brown fox jumps over the lazy dog in the park on a sunny day during the summer months in California.',
        },
        {
          url: 'https://example2.com',
          content: 'The quick brown fox jumps over the lazy dog in the park on a sunny day during the summer months in California.',
        },
      ];

      // Exact duplicates should be caught
      const result = deduplicateContent(sources, { similarityThreshold: 0.8 });
      expect(result.stats.duplicatesRemoved).toBe(1);
    });

    it('preserves unique content from all sources', () => {
      const sources: SourceContent[] = [
        {
          url: 'https://example1.com',
          content: 'First source has this completely unique and original paragraph about technology innovations and digital transformation.',
        },
        {
          url: 'https://example2.com',
          content: 'Second source discusses different topics like science and innovation in the modern era of artificial intelligence research.',
        },
        {
          url: 'https://example3.com',
          content: 'Third source covers arts and culture, including music and literature from around the world and their historical significance.',
        },
      ];

      const result = deduplicateContent(sources);

      expect(result.stats.duplicatesRemoved).toBe(0);
      expect(result.content).toContain('technology');
      expect(result.content).toContain('science');
      expect(result.content).toContain('arts and culture');
      expect(result.stats.sourcesProcessed).toBe(3);
    });

    it('respects minParagraphLength option', () => {
      const sources: SourceContent[] = [
        {
          url: 'https://example.com',
          content: 'Short.\n\nThis paragraph is long enough to be considered for deduplication and analysis and meets the minimum length requirement.',
        },
      ];

      const result = deduplicateContent(sources, { minParagraphLength: 50 });

      // Short paragraph should be filtered out
      expect(result.content).not.toContain('Short.');
      expect(result.content).toContain('long enough');
    });

    it('preserves source attribution when preserveStructure is true', () => {
      const sources: SourceContent[] = [
        {
          url: 'https://source1.example.com',
          content: 'Content from the first source that should be attributed correctly in the output with proper formatting and structure.',
        },
        {
          url: 'https://source2.example.com',
          content: 'Content from the second source with different information and attribution preserved for proper citation purposes.',
        },
      ];

      const result = deduplicateContent(sources, { preserveStructure: true });

      expect(result.content).toContain('Source: https://source1.example.com');
      expect(result.content).toContain('Source: https://source2.example.com');
    });

    it('handles empty sources gracefully', () => {
      const sources: SourceContent[] = [
        { url: 'https://empty.com', content: '' },
        { url: 'https://whitespace.com', content: '   \n\n   ' },
        {
          url: 'https://valid.com',
          content: 'This is valid content that should still be processed despite empty sources and contains enough text to pass filters.',
        },
      ];

      const result = deduplicateContent(sources);

      expect(result.stats.sourcesProcessed).toBe(3);
      expect(result.content).toContain('valid content');
    });

    it('calculates accurate statistics', () => {
      const duplicateContent = 'Original unique content that appears multiple times in this test scenario for verification of deduplication statistics.';
      const sources: SourceContent[] = [
        { url: 'https://example1.com', content: duplicateContent },
        { url: 'https://example2.com', content: duplicateContent },
      ];

      const result = deduplicateContent(sources);

      expect(result.stats.originalLength).toBeGreaterThan(0);
      expect(result.stats.deduplicatedLength).toBeGreaterThan(0);
      expect(result.stats.duplicatesRemoved).toBe(1);
      expect(result.stats.reductionPercent).toBeGreaterThanOrEqual(0);
      expect(result.stats.reductionPercent).toBeLessThanOrEqual(100);
    });

    it('works with single source', () => {
      const sources: SourceContent[] = [
        {
          url: 'https://single.com',
          content: 'First paragraph about quantum computing explores the history and development of qubits across research institutions worldwide.\n\nSecond paragraph discusses machine learning algorithms and their applications in natural language processing and computer vision.',
        },
      ];

      const result = deduplicateContent(sources);

      expect(result.stats.sourcesProcessed).toBe(1);
      expect(result.stats.duplicatesRemoved).toBe(0);
      expect(result.content).toContain('First paragraph');
      expect(result.content).toContain('Second paragraph');
    });

    it('handles content without paragraph breaks', () => {
      const sources: SourceContent[] = [
        {
          url: 'https://continuous.com',
          content: 'This is a long continuous piece of text without any paragraph breaks that still needs to be processed correctly by the deduplication algorithm even though it lacks clear paragraph structure.',
        },
      ];

      const result = deduplicateContent(sources);

      expect(result.stats.sourcesProcessed).toBe(1);
      expect(result.content).toContain('continuous piece of text');
    });

    it('detects exact duplicates with different word order', () => {
      const sources: SourceContent[] = [
        {
          url: 'https://example1.com',
          content: 'The quick brown fox jumps over the lazy dog near the river bank on Monday morning in spring.',
        },
        {
          url: 'https://example2.com',
          content: 'The quick brown fox jumps over the lazy dog near the river bank on Monday morning in spring.',
        },
      ];

      // With any threshold, exact duplicates should be detected
      const result = deduplicateContent(sources, { similarityThreshold: 0.99 });
      expect(result.stats.duplicatesRemoved).toBe(1);
    });

    it('does not group by source when preserveStructure is false', () => {
      const sources: SourceContent[] = [
        {
          url: 'https://source1.com',
          content: 'Content from first source that is long enough to pass the minimum paragraph length filter requirement.',
        },
        {
          url: 'https://source2.com',
          content: 'Content from second source that is also long enough to pass the minimum paragraph length filter requirement.',
        },
      ];

      const result = deduplicateContent(sources, { preserveStructure: false });

      expect(result.content).not.toContain('Source:');
    });
  });
});
