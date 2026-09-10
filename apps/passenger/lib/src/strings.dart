/// Every word the passenger reads.
class Ar {
  const Ar._();

  static const appName = 'مواصلات';
  static const whereTo = 'وين رايح؟';
  static const search = 'دوّر على المكان';
  static const noPlace = 'ما لقينا هالمكان';

  static const findingYou = 'جاري تحديد موقعك';
  static const needLocation = 'لازم نعرف وين إنت عشان نجيب لك الباص';
  static const noLineHere = 'ما في خط من هون لهالمكان';

  static const noBusNow = 'ما في باص شغال هلق';
  static const departsFrom = 'الباصات بتطلع من';
  static const imWaiting = 'أنا مستني هون';
  static const iBoarded = 'ركبت';
  static const cancel = 'إلغاء';
  static const confirmCancel = 'متأكد إنك بدك تلغي؟';
  static const yesCancel = 'نعم، ألغي';
  static const notYet = 'لا';

  static const waitingForBus = 'الباص جاي';
  static const requestExpired = 'انتهى الطلب. جرّب مرة ثانية.';
  static const reconnecting = 'جاري إعادة الاتصال...';

  /// "بضل ١٢ دقيقة"
  static String minutesLeft(int minutes) => 'بضل $minutes دقيقة';
}
