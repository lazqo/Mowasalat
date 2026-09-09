/// Every word the driver reads.
///
/// Arabic is the source language, not a translation. These are the words
/// drivers actually say — وين رايح؟, ابدأ, خلصت — not formal equivalents.
class Ar {
  const Ar._();

  static const appName = 'مواصلات';

  // Sign in
  static const welcome = 'مرحبا';
  static const phoneNumber = 'رقم الهاتف';
  static const sendCode = 'أرسل الرمز';
  static const enterCode = 'أدخل رمز التحقق';
  static const verify = 'تأكيد';
  static const codeByPerson = 'رح يوصلك الرمز من الموظف';
  static const resendIn = 'أعد الإرسال بعد';

  // Home
  static const whereTo = 'وين رايح؟';
  static const yourLines = 'خطوطك';
  static const noLines = 'ما في خطوط مسجلة إلك. راجع الموظف بالمجمع.';

  // Vehicle
  static const yourBus = 'الباص';
  static const coaster = 'باص';
  static const service = 'سرفيس';
  static const colour = 'اللون';
  static const plate = 'رقم اللوحة';
  static const showPlate = 'أظهر اللوحة للركاب';
  static const optional = 'اختياري';

  // Trip
  static const start = 'ابدأ';
  static const endTrip = 'إنهاء الرحلة';
  static const confirmEnd = 'متأكد إنك خلصت الرحلة؟';
  static const yesEnded = 'نعم، خلصت';
  static const notYet = 'لسه';
  static const tripRunning = 'الرحلة شغالة';
  static const nobodyWaiting = 'ما في ركاب بانتظارك';
  static const offCorridor = 'إنت بعيد عن الخط';
  static const reconnecting = 'جاري إعادة الاتصال...';

  // Recovery
  static const tripStillRunning = 'في رحلة شغالة';
  static const continueTrip = 'استمرار الرحلة';

  /// "٣ ركاب بانتظارك"
  static String waitingForYou(int count) =>
      count == 1 ? 'راكب بانتظارك' : '$count ركاب بانتظارك';
}
