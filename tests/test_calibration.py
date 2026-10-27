import math
import unittest
from analyze_calibration import fit_ratings


class Ratings(unittest.TestCase):
    def test_draws_and_symmetric_cycle_have_equal_strength(self):
        for pairs in [[(0,1,10,5),(0,2,10,5),(1,2,10,5)],
                      [(0,1,10,10),(0,2,10,0),(1,2,10,10)]]:
            self.assertEqual(fit_ratings(3,pairs),[1000.0]*3)

    def test_sweep_is_finite_and_has_exact_smoothed_odds(self):
        a,b=fit_ratings(2,[(0,1,10,10)])
        self.assertAlmostEqual(a-b,400*math.log10(11),places=6)
        self.assertAlmostEqual((a+b)/2,1000)

    def test_reversing_sides_and_game_order_does_not_change_fit(self):
        pairs=[(0,1,10,8),(0,2,10,9),(1,2,10,6)]
        expected=fit_ratings(3,pairs)
        actual=fit_ratings(3,[(j,i,n,n-s) for i,j,n,s in reversed(pairs)])
        for a,b in zip(expected,actual): self.assertAlmostEqual(a,b)
        self.assertGreater(actual[0],actual[1]); self.assertGreater(actual[1],actual[2])
        self.assertAlmostEqual(sum(actual),3000)


if __name__=='__main__': unittest.main()
