# M2 样例：简单 Perl 脚本。perl 有 helix 查询但不在 lite 内嵌集（apps/web/static/grammars
# 由 pnpm gen:grammars 按需生成）→ 引擎无 grammar → 自动降级 hljs 整文件，
# 覆盖降级链的真实路径（全量部署装上 perl grammar 后本文件走 tree-sitter 主路径）。
use strict;
use warnings;

my %counts;
open my $fh, '<', $ARGV[0] or die "cannot open $ARGV[0]: $!";
while (my $line = <$fh>) {
    for my $word (split /\s+/, lc $line) {
        $counts{$word}++;
    }
}
close $fh;

for my $word (sort { $counts{$b} <=> $counts{$a} } keys %counts) {
    printf "%-20s %d\n", $word, $counts{$word};
}
